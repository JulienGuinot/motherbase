import { ExternalLink, Building2, Info } from 'lucide-react';
import SettingsForm from '@/shared/ui/SettingsForm';
import { SubPage } from '@/shared/ui/SubPage';
import { Section } from '@/shared/ui/Section';
import { ConfigOnlyNotice } from '@/features/auth/components/ConfigOnlyNotice';

export default function Organizations() {
  return (
    <SubPage
      title="Organizations"
      description="Configure the organizations your end users create, including teams and membership limits. SSO is a separate project-wide switch below; organization-specific identity providers are registered by org admins at runtime."
    >
      <ConfigOnlyNotice
        subject="end-user organizations"
        tables={['organization', 'member', 'team', 'ssoProvider']}
      />
      <SettingsForm
        group="auth.organization"
        description="This controls Better Auth's organization plugin: whether organizations are available, whether users may create them, whether they can contain teams, and the maximum number of members. It does not enable or disable SSO."
      />

      <Section
        title="SSO is configured separately"
        description="Per-organization SSO uses the same SSO plugin as project-wide SSO. There is no organization-level SSO toggle."
      >
        <div className="flex items-start gap-3 rounded-md border px-3 py-3" style={{ borderColor: 'color-mix(in srgb, var(--accent) 28%, var(--border))', background: 'color-mix(in srgb, var(--accent) 7%, var(--surface-2))' }}>
          <Info size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            Enable <strong style={{ color: 'var(--text)' }}>Auth · SSO</strong> to mount the SSO plugin and its <span className="mono">/api/auth/sso/*</span> endpoints. When it is off, no organization can register or use an identity provider, regardless of its own organization settings.
          </p>
        </div>
      </Section>

      <SettingsForm
        group="auth.sso"
        description="The only switch that governs OIDC / SAML SSO, including per-organization SSO. Which provider a user reaches is tenant data stored in ssoProvider records, not a project setting here."
      />

      <Section title="How per-organization SSO works" description="The console enables the capability; the organization admin supplies the provider details.">
        <ol className="space-y-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          <li className="flex gap-2"><span style={{ color: 'var(--accent)' }}>1.</span> An operator enables <span style={{ color: 'var(--text)' }}>Auth · SSO</span> above.</li>
          <li className="flex gap-2"><span style={{ color: 'var(--accent)' }}>2.</span> An org admin registers an OIDC/SAML provider scoped to their <span className="mono">organizationId</span> via the client SDK.</li>
          <li className="flex gap-2"><span style={{ color: 'var(--accent)' }}>3.</span> Members sign in with <span className="mono">auth.signIn.sso(&#123; email, callbackURL &#125;)</span> and are routed to the matching provider.</li>
        </ol>
        <div className="mt-4 flex items-center gap-2 rounded-md border hairline px-3 py-2.5" style={{ background: 'var(--surface-2)' }}>
          <Building2 size={14} style={{ color: 'var(--text-mute)' }} />
          <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Provider records live in the <span className="mono">ssoProvider</span> table as tenant data, keyed per organization.</span>
        </div>
        <a
          className="mt-3 inline-flex items-center gap-1.5 text-[12.5px]"
          style={{ color: 'var(--accent)' }}
          href="https://www.better-auth.com/docs/plugins/sso"
          target="_blank"
          rel="noreferrer"
        >
          SSO plugin documentation <ExternalLink size={12} />
        </a>
      </Section>
    </SubPage>
  );
}
