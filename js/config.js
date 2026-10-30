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
  SHORTCUT_URL: 'https://www.icloud.com/shortcuts/87ed7c32e54444ce9bc2b7132e52e8f7',

  // Must match the shortcut's name exactly – used by the "Sync now" button.
  SHORTCUT_NAME: 'Friends sync',
};
