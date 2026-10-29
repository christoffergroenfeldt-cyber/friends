// ---------------------------------------------------------------
// Fill these in after creating your Supabase project (see README).
// The anon/publishable key is meant to be public – it is safe here.
// ---------------------------------------------------------------
export const CONFIG = {
  // Supabase → Project Settings → API → Project URL
  SUPABASE_URL: 'https://rtmiutusczdvoyxcprvl.supabase.co',

  // Supabase → Project Settings → API Keys → anon / publishable key
  SUPABASE_ANON_KEY: 'sb_publishable_VHEgfroy-bg7bvmtNz695A_L-fChpZV',

  // Public VAPID key for push notifications (generate with tools/vapid.html).
  // Leave empty to run without notifications.
  VAPID_PUBLIC_KEY: '',

  // iCloud link to the "Friends Sync" shortcut once you have built and shared it.
  SHORTCUT_URL: 'https://www.icloud.com/shortcuts/c00a956b43f7410f9bb841cce49357a1',

  // Must match the shortcut's name exactly – used by the "Sync now" button.
  SHORTCUT_NAME: 'Friends Sync',
};
