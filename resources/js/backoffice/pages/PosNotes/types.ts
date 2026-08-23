/**
 * `PosNotes/Index` props — predefined notes (BOF-112).
 *
 * The one-tap notes staff pick instead of typing: "no ice", "allergy — nuts", "fire together". The
 * scope decides where the note can be attached, and it is the only field here with consequences —
 * a line note travels to the kitchen on that line, an order note applies to the whole ticket.
 */

export type PosNoteRow = {
    id: number;
    name: string;
    color: number;
    /** `line | order | both` */
    note_scope: string;
    sequence: number;
    active: boolean;
};

export type PosNotesIndexProps = {
    notes: PosNoteRow[];
};

export const NOTE_SCOPE_LABEL: Record<string, string> = {
    line: 'Ligne',
    order: 'Commande',
    both: 'Les deux',
};
