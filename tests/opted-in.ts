// A test lead's consent when it has agreed to WhatsApp messages, so the guard before every send lets a WhatsApp
// message through to it (whatsappOptInHook, packages/harness/src/policies/whatsapp-opt-in.ts). The product records it
// through recordWhatsAppOptIn (packages/db/src/consent.ts); tests that seed leads directly use this value.
export const OPTED_IN = JSON.stringify({
  dnc: false,
  whatsapp_optin: { status: "opted_in", source: "test fixture" },
});
