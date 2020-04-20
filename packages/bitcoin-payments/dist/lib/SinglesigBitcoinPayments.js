import * as bitcoin from 'bitcoinjs-lib';
import { TransactionStatus, } from '@faast/payments-common';
import { publicKeyToString, getSinglesigPaymentScript } from './helpers';
import { BaseBitcoinPayments } from './BaseBitcoinPayments';
import { DEFAULT_SINGLESIG_ADDRESS_TYPE } from './constants';
export class SinglesigBitcoinPayments extends BaseBitcoinPayments {
    constructor(config) {
        super(config);
        this.addressType = config.addressType || DEFAULT_SINGLESIG_ADDRESS_TYPE;
    }
    getPaymentScript(index) {
        return getSinglesigPaymentScript(this.bitcoinjsNetwork, this.addressType, this.getKeyPair(index).publicKey);
    }
    signMultisigTransaction(tx) {
        const { multisigData, data } = tx;
        const { rawHex } = data;
        if (!multisigData)
            throw new Error('Not a multisig tx');
        if (!rawHex)
            throw new Error('Cannot sign multisig tx without unsigned tx hex');
        const psbt = bitcoin.Psbt.fromHex(rawHex, this.psbtOptions);
        const accountIds = this.getAccountIds();
        const updatedSignersData = [];
        let totalSignaturesAdded = 0;
        for (let signer of multisigData.signers) {
            if (!accountIds.includes(signer.accountId)) {
                updatedSignersData.push(signer);
                continue;
            }
            const keyPair = this.getKeyPair(signer.index);
            const publicKeyString = publicKeyToString(keyPair.publicKey);
            if (signer.publicKey !== publicKeyString) {
                throw new Error(`Mismatched publicKey for keyPair ${signer.accountId}/${signer.index} - `
                    + `multisigData has ${signer.publicKey} but keyPair has ${publicKeyString}`);
            }
            psbt.signAllInputs(keyPair);
            updatedSignersData.push({
                ...signer,
                signed: true,
            });
            totalSignaturesAdded += 1;
        }
        if (totalSignaturesAdded === 0) {
            throw new Error('Not a signer for provided multisig tx');
        }
        const newTxHex = psbt.toHex();
        return {
            ...tx,
            id: '',
            status: TransactionStatus.Signed,
            multisigData: {
                ...multisigData,
                signers: updatedSignersData,
            },
            data: {
                hex: newTxHex,
                partial: true,
                unsignedTxHash: data.rawHash,
            }
        };
    }
    async signTransaction(tx) {
        if (tx.multisigData) {
            return this.signMultisigTransaction(tx);
        }
        const paymentTx = tx.data;
        if (!paymentTx.rawHex) {
            throw new Error('Cannot sign bitcoin tx without rawHex');
        }
        const psbt = bitcoin.Psbt.fromHex(paymentTx.rawHex, this.psbtOptions);
        const keyPair = this.getKeyPair(tx.fromIndex);
        psbt.signAllInputs(keyPair);
        return this.validateAndFinalizeSignedTx(tx, psbt);
    }
}
//# sourceMappingURL=SinglesigBitcoinPayments.js.map