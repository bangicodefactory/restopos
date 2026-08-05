import type { JSX } from 'react';

import { ApprovalDialog } from './dialogs/ApprovalDialog';
import { ComboDialog } from './dialogs/ComboDialog';
import { CustomerDialog } from './dialogs/CustomerDialog';
import {
    CashMoveDialog,
    GuestsDialog,
    OrderNameDialog,
    ProductInfoDialog,
    SendBeforePayDialog,
} from './dialogs/MiscDialogs';
import { NotesDialog } from './dialogs/NotesDialog';
import { OpenPriceDialog } from './dialogs/OpenPriceDialog';
import { ScaleDialog } from './dialogs/ScaleDialog';
import { VariantDialog } from './dialogs/VariantDialog';
import { SyncDrawer } from './SyncDrawer';

/**
 * One mount point for every modal.
 *
 * Each dialog reads the UI store itself and renders `null` when it is not the open one, so adding a
 * dialog is adding a component here — no registry, no prop threading, and no chance of two dialogs
 * fighting over the top layer (the native `<dialog>` element handles that).
 */
export function DialogHost({ onSend, onPay }: { onSend: () => void; onPay: () => void }): JSX.Element {
    return (
        <>
            <VariantDialog />
            <ComboDialog />
            <ScaleDialog />
            <OpenPriceDialog />
            <CustomerDialog />
            <NotesDialog />
            <GuestsDialog />
            <OrderNameDialog />
            <CashMoveDialog />
            <ProductInfoDialog />
            <ApprovalDialog />
            <SendBeforePayDialog onSend={onSend} onPay={onPay} />
            <SyncDrawer />
        </>
    );
}
