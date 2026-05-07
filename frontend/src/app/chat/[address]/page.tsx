import { redirect } from 'next/navigation';

export default async function ChatAddressRedirect({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  redirect(`/chat?peer=${address.toLowerCase()}`);
}
