export interface VerificationEmail {
  to: string;
  code: string;
  expiresInMinutes: number;
}

// A future adapter must reject on non-acceptance, have a bounded timeout, and
// never log the payload. It must be explicitly wired here after provider selection.
export interface EmailAdapter {
  assertConfigured(): void;
  sendVerificationEmail(email: VerificationEmail): Promise<void>;
}

export const unconfiguredEmail: EmailAdapter = {
  assertConfigured() { throw new Error("email_not_configured"); },
  async sendVerificationEmail() { throw new Error("email_not_configured"); },
};

export function verificationEmailText(email: VerificationEmail): { subject: string; body: string } {
  return {
    subject: "[PartnerDesk] 로그인 인증번호",
    body: [
      "PartnerDesk 로그인 인증번호입니다.", "", `인증번호: ${email.code}`, "",
      `유효시간: ${email.expiresInMinutes}분`, "",
      "본인이 요청하지 않은 경우 즉시 비밀번호를 변경해 주세요.",
    ].join("\n"),
  };
}
