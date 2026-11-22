import { Link } from 'react-router-dom';

const sections = {
  privacy: {
    title: 'Privacy Policy',
    updated: 'Last updated: November 2026',
    intro: 'Mantraa Studio helps teams manage messages from websites, Messenger, Instagram, and WhatsApp in one shared inbox.',
    blocks: [
      {
        heading: 'Information we collect',
        body: 'We collect account details, workspace and channel settings, message content needed to provide the inbox, and usage data needed to operate the service.',
      },
      {
        heading: 'How we use it',
        body: 'We use this information to deliver messages, generate AI-assisted replies, show analytics, secure accounts, and provide support.',
      },
      {
        heading: 'Connected platforms',
        body: 'When you connect Meta channels, we store the access tokens you authorise so we can send and receive messages for those channels. We do not sell your data.',
      },
      {
        heading: 'Data deletion',
        body: 'You can disconnect any channel from Settings > Channels at any time. To delete your account and associated workspace data, email socialhub787123@gmail.com with the subject "Data deletion request".',
      },
      {
        heading: 'Contact',
        body: 'Questions about this policy can be sent to socialhub787123@gmail.com.',
      },
    ],
  },
  terms: {
    title: 'Terms of Service',
    updated: 'Last updated: November 2026',
    intro: 'These terms govern your use of Mantraa Studio and its connected channel features.',
    blocks: [
      {
        heading: 'Your accounts',
        body: 'You are responsible for the accounts and pages you connect, the permissions you grant, and the messages sent through your workspace.',
      },
      {
        heading: 'Acceptable use',
        body: 'Do not use the service for spam, harassment, unlawful activity, or anything that violates the policies of connected platforms such as Meta or Google.',
      },
      {
        heading: 'Service availability',
        body: 'The service is provided as-is. Connected platforms may change their APIs or policies, which can affect channel features.',
      },
      {
        heading: 'Termination',
        body: 'You may stop using the service at any time. We may suspend access if these terms are violated or if required by a connected platform.',
      },
      {
        heading: 'Contact',
        body: 'Questions about these terms can be sent to socialhub787123@gmail.com.',
      },
    ],
  },
};

export default function Legal({ kind }) {
  const page = sections[kind] ?? sections.privacy;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">Mantraa Studio</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">{page.title}</h1>
        <p className="mt-1 text-xs text-slate-500">{page.updated}</p>
        <p className="mt-5 text-sm leading-6 text-slate-700">{page.intro}</p>

        <div className="mt-6 space-y-5">
          {page.blocks.map((block) => (
            <section key={block.heading}>
              <h2 className="text-sm font-semibold text-slate-900">{block.heading}</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">{block.body}</p>
            </section>
          ))}
        </div>

        <Link to="/login" className="mt-8 inline-block text-sm font-medium text-brand-700 hover:underline">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
