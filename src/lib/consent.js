// UI acknowledgement is bound to the exact immutable server document.
export function consentSubmission(policy, agreed) {
  if (!agreed || !policy?.kind || !policy?.version || !/^[0-9a-f]{64}$/.test(policy?.text_hash || '')) return null;
  return { p_kind: policy.kind, p_version: policy.version, p_text_hash: policy.text_hash, p_agreed: true };
}

export function signupConsentEntries(policies, acknowledgements) {
  if (!Array.isArray(policies) || policies.some(p => p.required && acknowledgements[p.kind] !== true)) return null;
  return policies.filter(p => acknowledgements[p.kind] === true).map(p => {
    const submission = consentSubmission(p, true);
    if (!submission) throw new Error('동의 문서를 확인하지 못했습니다. 새로고침해 주세요.');
    return { kind: p.kind, version: p.version, text_hash: p.text_hash, agreed: true };
  });
}
