import { redirect } from 'next/navigation';

// /settings → /settings/connections (default settings sub-route)
export default function SettingsPage() {
  redirect('/settings/connections');
}
