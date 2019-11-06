import { AccountStellarPaymentsConfig, PartialStellarSignatory, } from './types';
import { BaseStellarPayments } from './BaseStellarPayments';
import { assertType } from '@faast/ts-common';
import { isValidAddress, isValidSecret } from './helpers';
import * as Stellar from 'stellar-sdk';
export class AccountStellarPayments extends BaseStellarPayments {
    constructor(config) {
        super(config);
        this.readOnly = false;
        assertType(AccountStellarPaymentsConfig, config);
        this.hotSignatory = this.accountConfigToSignatory(config.hotAccount);
        this.depositSignatory = this.accountConfigToSignatory(config.depositAccount);
    }
    accountConfigToSignatory(accountConfig) {
        if (PartialStellarSignatory.is(accountConfig)) {
            if (!accountConfig.secret) {
                if (!accountConfig.address) {
                    throw new Error('Invalid StellarSecretPair, either secret or address required');
                }
                this.readOnly = true;
                return {
                    address: accountConfig.address,
                    secret: '',
                };
            }
            const keyPair = Stellar.Keypair.fromSecret(accountConfig.secret);
            return {
                address: keyPair.publicKey(),
                secret: keyPair.secret(),
            };
        }
        else if (isValidAddress(accountConfig)) {
            this.readOnly = true;
            return {
                address: accountConfig,
                secret: '',
            };
        }
        else if (isValidSecret(accountConfig)) {
            const keyPair = Stellar.Keypair.fromSecret(accountConfig);
            return {
                address: keyPair.publicKey(),
                secret: keyPair.secret(),
            };
        }
        throw new Error('Invalid stellar account config provided to stellar payments');
    }
    isReadOnly() {
        return this.readOnly;
    }
    getPublicAccountConfig() {
        return {
            hotAccount: this.hotSignatory.address,
            depositAccount: this.depositSignatory.address,
        };
    }
    getAccountIds() {
        return [this.hotSignatory.address, this.depositSignatory.address];
    }
    getAccountId(index) {
        if (index < 0) {
            throw new Error(`Invalid stellar payments accountId index ${index}`);
        }
        if (index === 0) {
            return this.hotSignatory.address;
        }
        return this.depositSignatory.address;
    }
    getHotSignatory() {
        return this.hotSignatory;
    }
    getDepositSignatory() {
        return this.depositSignatory;
    }
}
//# sourceMappingURL=AccountStellarPayments.js.map