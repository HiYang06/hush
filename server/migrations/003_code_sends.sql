-- Every login code mailed, for the daily limits per address, per IP and in total (the mail service has a
-- daily quota). login_codes keeps only the latest code per address, so it can't be counted. Rows older
-- than two days are pruned when a code is sent.
CREATE TABLE code_sends (
  email   text NOT NULL,
  ip      text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX code_sends_email ON code_sends(email, sent_at);
CREATE INDEX code_sends_ip ON code_sends(ip, sent_at);
CREATE INDEX code_sends_sent_at ON code_sends(sent_at);
