import { useCallback, useState, type JSX } from 'react';

import { Button } from './Button';
import { cn } from './cn';

/**
 * On-screen keyboard.
 *
 * A till often has no physical keyboard, and the OS keyboard on a kiosk-mode tablet either does not
 * appear or covers the screen. So we ship one: customer names, order notes and search all need it.
 *
 * Layouts are data, not markup, so a venue running an Arabic or French kiosk gets the right keys
 * without a component fork.
 */

export type KeyboardLayout = 'qwerty' | 'azerty' | 'arabic' | 'numeric';

const LAYOUTS: Record<KeyboardLayout, string[][]> = {
    qwerty: [
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
        ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
    ],
    azerty: [
        ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm'],
        ['w', 'x', 'c', 'v', 'b', 'n'],
    ],
    arabic: [
        ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح'],
        ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك'],
        ['ئ', 'ء', 'ؤ', 'ر', 'ى', 'ة', 'و', 'ز', 'ظ'],
    ],
    numeric: [
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9'],
        ['0', '.', '-'],
    ],
};

export type KeyboardProps = {
    value: string;
    onChange: (next: string) => void;
    onSubmit?: (value: string) => void;
    layout?: KeyboardLayout;
    /** Shown on the wide key; `space` for text, `next` for a form flow. */
    submitLabel?: string;
    className?: string;
    /** Right-to-left languages reverse the row order visually via `dir`. */
    rtl?: boolean;
};

export function Keyboard({
    value,
    onChange,
    onSubmit,
    layout = 'qwerty',
    submitLabel = 'Enter',
    className,
    rtl = false,
}: KeyboardProps): JSX.Element {
    const [shift, setShift] = useState(false);
    const rows = LAYOUTS[layout];

    const type = useCallback(
        (key: string) => {
            onChange(value + (shift ? key.toUpperCase() : key));
            if (shift) setShift(false);
        },
        [onChange, shift, value],
    );

    return (
        <div className={cn('flex flex-col gap-2 select-none', className)} dir={rtl ? 'rtl' : 'ltr'}>
            {rows.map((row, index) => (
                <div key={index} className="flex justify-center gap-1.5">
                    {row.map((key) => (
                        <Button
                            key={key}
                            variant="secondary"
                            size="lg"
                            className="min-w-touch flex-1 px-0 text-lg"
                            onClick={() => type(key)}
                        >
                            {shift ? key.toUpperCase() : key}
                        </Button>
                    ))}
                </div>
            ))}

            <div className="flex justify-center gap-1.5">
                <Button
                    variant={shift ? 'primary' : 'secondary'}
                    size="lg"
                    className="min-w-touch-lg px-3"
                    aria-pressed={shift}
                    onClick={() => setShift((on) => !on)}
                >
                    ⇧
                </Button>
                <Button variant="secondary" size="lg" className="flex-1" onClick={() => onChange(value + ' ')}>
                    space
                </Button>
                <Button
                    variant="secondary"
                    size="lg"
                    className="min-w-touch-lg px-3"
                    aria-label="Backspace"
                    onClick={() => onChange(value.slice(0, -1))}
                >
                    ⌫
                </Button>
                {onSubmit ? (
                    <Button variant="success" size="lg" className="min-w-touch-lg px-4" onClick={() => onSubmit(value)}>
                        {submitLabel}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
