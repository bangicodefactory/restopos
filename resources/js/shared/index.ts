/**
 * `@shared` — everything used by more than one front-end.
 *
 * Import from the sub-barrels (`@shared/db`, `@shared/ui`, …) in application code: it keeps the
 * import graph legible and lets the bundler drop what an app does not use. This root barrel exists
 * for convenience and for the boundary lint rule.
 *
 * Dependency direction is one-way and enforced by eslint:
 *
 *     @domain  ←  @shared  ←  @register | @kitchen | @selforder | @backoffice
 *
 * `@domain` never imports from here.
 */

export * from './db';
export * from './sync';
export * from './store';
export * from './auth';
export * from './printing';
export * from './ui';
export * from './i18n';
export * from './pwa/register-sw';
