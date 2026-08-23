/**
 * `PosBills/Index` props — cash denominations (BOF-111).
 *
 * A denomination is one physical coin or note the venue actually handles. The close-session count
 * sheet lists exactly these, so a currency whose denominations are wrong produces a count sheet
 * nobody can fill in against the drawer in front of them.
 */

import type { MoneyString } from '../../types/inertia';

export type PosBillRow = {
    id: number;
    currency_id: number;
    name: string;
    value: MoneyString;
    /** `bill | coin` */
    denomination_type: string;
    sequence: number;
    active: boolean;
};

export type BillCurrencyRow = {
    id: number;
    name: string;
    symbol: string;
};

export type PosBillsIndexProps = {
    bills: PosBillRow[];
    currencies: BillCurrencyRow[];
};

export const DENOMINATION_LABEL: Record<string, string> = {
    bill: 'Billet',
    coin: 'Pièce',
};
