export type Mailer = (email: string, code: string) => Promise<void>

export function resendMailer(apiKey: string, from: string): Mailer {
  return async (email, code) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Hush 登录验证码：${code}`,
        text: `你的 Hush 登录验证码是 ${code}，10 分钟内有效。\n\n如果不是你本人操作，忽略这封邮件即可。`
      })
    })
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
  }
}

export const consoleMailer: Mailer = async (email, code) => {
  console.log(`[dev] login code for ${email}: ${code}`)
}
