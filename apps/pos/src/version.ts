/** Carried by every document and push (sync spec §6.1, §6.2); the server accepts the previous version too (§4.2). */
export const CLIENT_VERSION = import.meta.env.VITE_ERP_VERSION ?? 'dev';
