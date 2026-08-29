import { Button, Dialog } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { customerDisplayUrl } from '../../domain/customer-display-link';
import { useCatalog } from '../../hooks/use-register';
import { useT } from '../../i18n';
import { useUiStore } from '../../state/ui-store';

/**
 * "Pair a customer display" (REG-356).
 *
 * The route `/pos/{config}/display` has existed since the display was built and there has never
 * been a way into it from the till — a manager had to know the URL and type it on the other device.
 * The whole content of this dialog is that URL, made reachable two ways:
 *
 *   * **Open here** for the ordinary case, a second monitor on this machine. `window.open` with a
 *     stable window name, so pressing it twice focuses the display rather than stacking a second
 *     one on top of it.
 *   * **Copy** for the other case, a tablet across the counter. The clipboard is as far as this
 *     goes; a QR would be better and is not here, because the encoder lives in the back-office
 *     bundle and pulling it across app boundaries is a bigger change than this ticket.
 *
 * The URL carries the display's capability token when the config has one. A register that has not
 * bootstrapped yet has no token, and the URL it shows still works on the same machine over
 * `BroadcastChannel` — so the dialog is useful before the token exists rather than being blocked
 * on it.
 */
export function CustomerDisplayDialog(): JSX.Element | null {
    const t = useT();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const catalog = useCatalog();
    const [copied, setCopied] = useState(false);

    if (dialog?.kind !== 'customerDisplay') return null;

    const configId = catalog.config?.id ?? null;
    const url =
        configId === null
            ? null
            : customerDisplayUrl(
                  globalThis.location?.origin ?? '',
                  configId,
                  catalog.config?.customer_display_token ?? null,
              );

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.display.pairTitle')}
            footer={
                <Button variant="ghost" onClick={close}>
                    {t('common.close')}
                </Button>
            }
        >
            <div className="space-y-3">
                <p className="text-slate-600">{t('reg.display.pairHelp')}</p>

                {url === null ? (
                    <p className="text-warn-fg">{t('reg.display.pairUnavailable')}</p>
                ) : (
                    <>
                        <code
                            data-testid="customer-display-url"
                            data-display-url={url}
                            className="block rounded-pos bg-slate-100 px-3 py-2 break-all"
                        >
                            {url}
                        </code>

                        <div className="flex gap-2">
                            <Button
                                data-testid="customer-display-open"
                                onClick={() => {
                                    globalThis.open?.(url, 'restopos-customer-display');
                                }}
                            >
                                {t('reg.display.pairOpen')}
                            </Button>
                            <Button
                                variant="ghost"
                                data-testid="customer-display-copy"
                                onClick={() => {
                                    void globalThis.navigator?.clipboard?.writeText(url).then(() => setCopied(true));
                                }}
                            >
                                {copied ? t('reg.display.pairCopied') : t('reg.display.pairCopy')}
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </Dialog>
    );
}
