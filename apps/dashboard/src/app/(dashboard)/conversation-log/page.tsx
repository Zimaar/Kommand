import { redirect } from 'next/navigation';

// /conversation-log → /settings/conversations (canonical path)
export default function ConversationLogRedirect() {
  redirect('/settings/conversations');
}
