import { redirect } from 'next/navigation';

// /connections → /settings/connections (canonical path)
export default function ConnectionsRedirect() {
  redirect('/settings/connections');
}
