import { BaseBitcoinPayments } from './BaseBitcoinPayments';
import { HdBitcoinPaymentsConfig, } from './types';
import { omit } from 'lodash';
import { HdBitcoinPayments } from './HdBitcoinPayments';
import { KeyPairBitcoinPayments } from './KeyPairBitcoinPayments';
import * as bitcoin from 'bitcoinjs-lib';
import { publicKeyToString, getMultisigPaymentScript } from './helpers';
import { DEFAULT_MULTISIG_ADDRESS_TYPE } from './constants';
export class MultisigBitcoinPayments extends BaseBitcoinPayments {
    constructor(config) {
        super(config);
        this.config = config;
        this.addressType = config.addressType || DEFAULT_MULTISIG_ADDRESS_TYPE;
        this.m = config.m;
        this.signers = config.signers.map((signerConfig, i) => {
            signerConfig = {
                network: this.networkType,
                logger: this.logger,
                ...signerConfig,
            };
            if (signerConfig.network !== this.networkType) {
                throw new Error(`MultisigBitcoinPayments is on network ${this.networkType} but signer config ${i} is on ${signerConfig.network}`);
            }
            if (HdBitcoinPaymentsConfig.is(signerConfig)) {
                return new HdBitcoinPayments(signerConfig);
            }
            else {
                return new KeyPairBitcoinPayments(signerConfig);
            }
        });
    }
    getFullConfig() {
        return {
            ...this.config,
            network: this.networkType,
            addressType: this.addressType,
        };
    }
    getPublicConfig() {
        return {
            ...omit(this.getFullConfig(), ['logger', 'server', 'signers']),
            signers: this.signers.map((signer) => signer.getPublicConfig()),
        };
    }
    getAccountId(index) {
        throw new Error('Multisig payments does not have single account for an index, use getAccountIds(index) instead');
    }
    getAccountIds(index) {
        return this.signers.reduce((result, signer) => ([...result, ...signer.getAccountIds(index)]), []);
    }
    getSignerPublicKeyBuffers(index) {
        return this.signers.map((signer) => signer.getKeyPair(index).publicKey);
    }
    getPaymentScript(index) {
        return getMultisigPaymentScript(this.bitcoinjsNetwork, this.addressType, this.getSignerPublicKeyBuffers(index), this.m);
    }
    getAddress(index) {
        const { address } = this.getPaymentScript(index);
        if (!address) {
            throw new Error('bitcoinjs-lib address derivation returned falsy value');
        }
        return address;
    }
    getMultisigData(index) {
        return {
            m: this.m,
            signers: this.signers.map((signer) => ({
                accountId: signer.getAccountId(index),
                index: index,
                publicKey: publicKeyToString(signer.getKeyPair(index).publicKey)
            }))
        };
    }
    async createTransaction(from, to, amount, options) {
        const tx = await super.createTransaction(from, to, amount, options);
        return {
            ...tx,
            multisigData: this.getMultisigData(from),
        };
    }
    async createMultiOutputTransaction(from, to, options = {}) {
        const tx = await super.createMultiOutputTransaction(from, to, options);
        return {
            ...tx,
            multisigData: this.getMultisigData(from),
        };
    }
    async createSweepTransaction(from, to, options = {}) {
        const tx = await super.createSweepTransaction(from, to, options);
        return {
            ...tx,
            multisigData: this.getMultisigData(from),
        };
    }
    deserializeSignedTxPsbt(tx) {
        if (!tx.data.partial) {
            throw new Error('Cannot decode psbt of a finalized tx');
        }
        return bitcoin.Psbt.fromHex(tx.data.hex, this.psbtOptions);
    }
    getPublicKeysOfSigned(multisigData) {
        return multisigData.signers.filter(({ signed }) => signed).map(({ publicKey }) => publicKey);
    }
    setMultisigSignersAsSigned(multisigData, signedPubKeys) {
        const combinedSignerData = multisigData.signers.map((signer) => {
            if (signedPubKeys.has(signer.publicKey)) {
                return {
                    ...signer,
                    signed: true,
                };
            }
            return signer;
        });
        return {
            ...multisigData,
            signers: combinedSignerData,
        };
    }
    async combinePartiallySignedTransactions(txs) {
        if (txs.length < 2) {
            throw new Error(`Cannot combine ${txs.length} transactions, need at least 2`);
        }
        const unsignedTxHash = txs[0].data.unsignedTxHash;
        txs.forEach(({ multisigData, inputUtxos, externalOutputs, data }, i) => {
            if (!multisigData)
                throw new Error(`Cannot combine signed multisig tx ${i} because multisigData is ${multisigData}`);
            if (!inputUtxos)
                throw new Error(`Cannot combine signed multisig tx ${i} because inputUtxos field is missing`);
            if (!externalOutputs)
                throw new Error(`Cannot combine signed multisig tx ${i} because externalOutputs field is missing`);
            if (data.unsignedTxHash !== unsignedTxHash)
                throw new Error(`Cannot combine signed multisig tx ${i} because unsignedTxHash is ${data.unsignedTxHash} when expecting ${unsignedTxHash}`);
            if (!data.partial)
                throw new Error(`Cannot combine signed multisig tx ${i} because partial is ${data.partial}`);
        });
        const baseTx = txs[0];
        const baseTxMultisigData = baseTx.multisigData;
        const { m } = baseTxMultisigData;
        const signedPubKeys = new Set(this.getPublicKeysOfSigned(baseTxMultisigData));
        let combinedPsbt = this.deserializeSignedTxPsbt(baseTx);
        for (let i = 1; i < txs.length; i++) {
            if (signedPubKeys.size >= m) {
                this.logger.debug('Already received enough signatures, not combining');
                break;
            }
            const tx = txs[i];
            const psbt = this.deserializeSignedTxPsbt(tx);
            combinedPsbt.combine(psbt);
            this.getPublicKeysOfSigned(tx.multisigData).forEach((pubkey) => signedPubKeys.add(pubkey));
        }
        const combinedHex = combinedPsbt.toHex();
        const combinedMultisigData = this.setMultisigSignersAsSigned(baseTxMultisigData, signedPubKeys);
        if (signedPubKeys.size >= m) {
            const finalizedTx = this.validateAndFinalizeSignedTx(baseTx, combinedPsbt);
            return {
                ...finalizedTx,
                multisigData: combinedMultisigData,
            };
        }
        return {
            ...baseTx,
            multisigData: combinedMultisigData,
            data: {
                hex: combinedHex,
                partial: true,
                unsignedTxHash,
            }
        };
    }
    async signTransaction(tx) {
        const partiallySignedTxs = await Promise.all(this.signers.map((signer) => signer.signTransaction(tx)));
        return this.combinePartiallySignedTransactions(partiallySignedTxs);
    }
}
export default MultisigBitcoinPayments;
//# sourceMappingURL=MultisigBitcoinPayments.js.map