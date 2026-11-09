'use client';

import { useEffect, useState } from 'react';
import { platform } from '@/shared/lib/api';
import { PROJECT_NAME_RE, sanitizeProjectName } from '@/features/projects/lib/blueprint';

/**
 * The new-project form fields and everything derived from them: the routes the
 * backend manifest would produce, and whether the form is complete.
 *
 * The derivation mirrors the server: the API domain defaults to
 * `<name>.<suffix>` and storage to `<name>-storage.<baseSuffix>`, so the
 * preview shows the real addresses rather than a guess.
 */
export function useProjectBlueprint() {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [domainTouched, setDomainTouched] = useState(false);
  const [storageDomain, setStorageDomain] = useState('');
  const [corsOrigins, setCorsOrigins] = useState('');
  const [info, setInfo] = useState({ mode: 'prod', domainSuffix: '' });

  useEffect(() => {
    platform
      .info()
      .then(i => setInfo({ mode: i.mode, domainSuffix: i.domainSuffix ?? '' }))
      .catch(() => setInfo({ mode: 'prod', domainSuffix: '' }));
  }, []);

  const dev = info.mode === 'dev';
  const scheme = dev ? 'http' : 'https';
  const suffix = dev ? 'localhost' : info.domainSuffix;

  const autoDomain = name && suffix ? `${name}.${suffix}` : '';
  const effectiveDomain = (domainTouched ? domain : domain || autoDomain).trim();

  const baseSuffix = effectiveDomain.includes('.')
    ? effectiveDomain.slice(effectiveDomain.indexOf('.') + 1)
    : '';
  const effectiveStorage =
    storageDomain.trim() || (effectiveDomain && baseSuffix ? `${name}-storage.${baseSuffix}` : '');

  return {
    name,
    setName: (value: string) => setName(sanitizeProjectName(value)),
    nameError: name !== '' && !PROJECT_NAME_RE.test(name),
    domain,
    domainTouched,
    setDomain: (value: string) => {
      setDomain(value);
      // Clearing the field re-enables the suffix-derived default.
      setDomainTouched(value.trim() !== '');
    },
    autoDomain,
    effectiveDomain,
    storageDomain,
    setStorageDomain,
    effectiveStorage,
    corsOrigins,
    setCorsOrigins,
    dev,
    scheme,
    suffix,
    suffixLabel: suffix || 'custom DNS',
    routeMode: domainTouched ? 'Custom' : autoDomain ? 'Auto' : 'Pending',
    isReady: PROJECT_NAME_RE.test(name) && (dev || Boolean(effectiveDomain)),
  };
}

export type ProjectBlueprint = ReturnType<typeof useProjectBlueprint>;
