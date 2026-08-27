/**
 * `Attributes/Index` props — the options behind "Large / extra cheese / no onions" (BOF-085).
 *
 * An attribute is defined once for the venue and *attached* to products. What a value costs is not
 * here: it is per product, on the attribute line, because "large" is +2.00 on a coffee and +6.00 on
 * a pizza.
 */

export type AttributeValueRow = {
    id: number;
    name: string;
    html_color: string | null;
    is_custom: boolean;
    sequence: number;
    active: boolean;
};

export type AttributeRow = {
    id: number;
    name: string;
    /** `radio | pills | select | color | multi` */
    display_type: string;
    /** `always | dynamic | no_variant` */
    create_variant: string;
    sequence: number;
    active: boolean;
    /** How many products offer it — what decides whether an edit here is small or menu-wide. */
    product_count: number;
    values: AttributeValueRow[];
};

export type AttributesIndexProps = {
    attributes: AttributeRow[];
};

/** What control the register and the kiosk render. `multi` is the only one that allows several. */
export const DISPLAY_TYPE_LABEL: Record<string, string> = {
    radio: 'Boutons radio',
    pills: 'Pastilles',
    select: 'Liste déroulante',
    color: 'Couleurs',
    multi: 'Choix multiple',
};

/**
 * Whether choosing a value produces a distinct variant.
 *
 * `always` mints one per combination — right for a size that has its own barcode and stock.
 * `no_variant` keeps a single sellable variant and records the choice on the order line, which is
 * what "no onions" wants: nobody stocks an onion-less burger.
 */
export const CREATE_VARIANT_LABEL: Record<string, string> = {
    always: 'Une variante par combinaison',
    dynamic: 'À la première vente',
    no_variant: 'Aucune variante (noté sur la ligne)',
};
