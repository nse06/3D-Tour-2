// Who is behind Atrium, as the legal pages (/legal/*) name it. Set these in the environment before
// launch: the defaults are placeholders. LEGAL_ADDRESS is required for EU visitors (a postal address
// on the legal notice); without it the pages leave the address out.

export const LEGAL = {
  /** The company's registered name, e.g. "Atrium Tours LLC". */
  company: process.env.LEGAL_COMPANY_NAME?.trim() || "Atrium",
  /** Where privacy requests and legal notices go. */
  email: process.env.LEGAL_CONTACT_EMAIL?.trim() || "privacy@atriumtour.com",
  /** Postal address, one line. */
  address: process.env.LEGAL_ADDRESS?.trim() || null,
  /** The US state whose law governs the Terms. */
  governingLaw: process.env.LEGAL_GOVERNING_LAW?.trim() || "Illinois",
  /** When the current versions took effect (update with every material change). */
  effective: "October 19, 2026",
};

/** Services that process personal data for Atrium (the privacy policy lists them). */
export const SUBPROCESSORS = [
  { name: "Vercel", purpose: "Hosting the website and walkthroughs", location: "United States" },
  { name: "Supabase", purpose: "Accounts, sign-in emails, database and file storage", location: "United States" },
  { name: "Stripe", purpose: "Payments, invoices and subscriptions", location: "United States" },
  { name: "Modal", purpose: "Cloud GPUs that build AI-enhanced models from scan photos", location: "United States" },
  { name: "Anthropic", purpose: "AI review of AI-enhanced models (a few scan photos and views of the model)", location: "United States" },
];
