import { createHash } from 'crypto';

function parseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch {}
  return null;
}

export class FeishuAlerter {
  constructor({ webhookUrl, appId, appSecret, receiveIdType, receiveId, receiveMobile, receiveEmail }) {
    this.webhookUrl = webhookUrl;
    this.appId = appId;
    this.appSecret = appSecret;
    this.receiveIdType = receiveIdType || 'open_id';
    this.receiveId = receiveId;
    this.receiveMobile = receiveMobile;
    this.receiveEmail = receiveEmail;
    this._tenantToken = null;
    this._tenantTokenExpireAt = 0;
    this._contentHashes = {};
  }

  get isConfigured() {
    return !!this.webhookUrl || !!(this.appId && this.appSecret && (this.receiveId || this.receiveMobile || this.receiveEmail));
  }

  async _getTenantAccessToken() {
    const now = Date.now();
    if (this._tenantToken && now < this._tenantTokenExpireAt - 60_000) return this._tenantToken;
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!res.ok) throw new Error(`token http ${res.status}`);
    const data = await res.json();
    if (data.code !== 0 || !data.tenant_access_token) throw new Error(data.msg || 'token failed');
    const expire = Number(data.expire || 7200);
    this._tenantToken = data.tenant_access_token;
    this._tenantTokenExpireAt = now + expire * 1000;
    return this._tenantToken;
  }

  async _resolveReceiveTarget() {
    if (this.receiveId) {
      return { idType: this.receiveIdType || 'open_id', id: this.receiveId };
    }
    if (!this.appId || !this.appSecret) return null;
    const token = await this._getTenantAccessToken();

    if (this.receiveMobile || this.receiveEmail) {
      const res = await fetch('https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          mobiles: this.receiveMobile ? [this.receiveMobile] : [],
          emails: this.receiveEmail ? [this.receiveEmail] : [],
          include_resigned: false,
        }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const firstByMobile = this.receiveMobile ? data?.data?.mobile_users?.[this.receiveMobile]?.[0] : null;
        const firstByEmail = this.receiveEmail ? data?.data?.email_users?.[this.receiveEmail]?.[0] : null;
        const firstFromList = data?.data?.user_list?.[0] || null;
        const openId = firstByMobile?.open_id || firstByEmail?.open_id || firstFromList?.open_id || firstFromList?.user_id || null;
        if (data.code === 0 && openId) {
          this.receiveId = openId;
          this.receiveIdType = 'open_id';
          return { idType: 'open_id', id: openId };
        }
      }
    }
    return null;
  }

  async _sendWebhookText(text) {
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async _sendAppText(text) {
    try {
      const target = await this._resolveReceiveTarget();
      if (!target) return false;
      const token = await this._getTenantAccessToken();
      const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.idType)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: target.id,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return data.code === 0;
    } catch {
      return false;
    }
  }

  async sendMessage(text) {
    if (!this.isConfigured) return false;
    if (this.appId && this.appSecret && (this.receiveId || this.receiveMobile || this.receiveEmail)) {
      const ok = await this._sendAppText(text);
      if (ok) return true;
    }
    if (this.webhookUrl) return this._sendWebhookText(text);
    return false;
  }

  _signalKey(signal) {
    return `${signal.source || 'unknown'}:${signal.key || signal.label || signal.text || 'n/a'}`;
  }

  _semanticHash(signal) {
    const txt = `${signal.source || ''}|${signal.label || ''}|${signal.changePct || ''}|${signal.current || ''}`;
    return createHash('sha256').update(txt).digest('hex').substring(0, 16);
  }

  _isSemanticDuplicate(signal, windowMs = 2 * 60 * 60 * 1000) {
    const hash = this._semanticHash(signal);
    const now = Date.now();
    const ts = this._contentHashes[hash];
    if (ts && now - ts < windowMs) return true;
    return false;
  }

  _recordContentHash(signal) {
    this._contentHashes[this._semanticHash(signal)] = Date.now();
  }

  _ruleBasedEvaluation(newSignals, delta) {
    const critical = delta?.summary?.criticalChanges || 0;
    if (critical >= 3 || newSignals.length >= 4) {
      return {
        shouldAlert: true,
        tier: 'PRIORITY',
        headline: 'Crucix Priority Alert',
        reason: `${newSignals.length} new/escalated signals detected; ${critical} critical changes.`,
        actionable: 'Review dashboard and hedge event risk if needed',
        signals: newSignals.slice(0, 5).map(s => s.label || s.text || s.key || 'signal'),
        confidence: 'MEDIUM',
      };
    }
    if (critical >= 1 || newSignals.length >= 2) {
      return {
        shouldAlert: true,
        tier: 'ROUTINE',
        headline: 'Crucix Routine Alert',
        reason: `${newSignals.length} notable signal changes detected.`,
        actionable: 'Monitor',
        signals: newSignals.slice(0, 4).map(s => s.label || s.text || s.key || 'signal'),
        confidence: 'LOW',
      };
    }
    return { shouldAlert: false, reason: 'insufficient signal intensity' };
  }

  _formatAlert(evaluation, delta, source = 'llm') {
    return [
      `【CRUCIX ${evaluation.tier || 'ROUTINE'}】${evaluation.headline || 'Signal Alert'}`,
      `${evaluation.reason || ''}`,
      `Direction: ${(delta?.summary?.direction || 'mixed').toUpperCase()} | Changes: ${delta?.summary?.totalChanges || 0} | Critical: ${delta?.summary?.criticalChanges || 0}`,
      `Confidence: ${evaluation.confidence || 'MEDIUM'} | Source: ${source}`,
      evaluation.signals?.length ? `Signals: ${evaluation.signals.join(' · ')}` : '',
      `${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC`,
    ].filter(Boolean).join('\n');
  }

  async evaluateAndAlert(llmProvider, delta, memory) {
    if (!this.isConfigured) return false;
    if (!delta?.summary?.totalChanges) return false;

    const allSignals = [ ...(delta.signals?.new || []), ...(delta.signals?.escalated || []) ];
    const newSignals = allSignals.filter(s => {
      const key = this._signalKey(s);
      if (typeof memory.isSignalSuppressed === 'function') {
        if (memory.isSignalSuppressed(key)) return false;
      } else {
        const alerted = memory.getAlertedSignals();
        if (alerted[key]) return false;
      }
      if (this._isSemanticDuplicate(s)) return false;
      return true;
    });
    if (newSignals.length === 0) return false;

    let evaluation = null;
    let evalSource = 'rules';

    if (llmProvider?.isConfigured) {
      try {
        const { TelegramAlerter } = await import('./telegram.mjs');
        const tgInstance = new TelegramAlerter({ botToken: null, chatId: null });
        const systemPrompt = tgInstance._buildEvaluationPrompt();
        const userMessage = tgInstance._buildSignalContext(newSignals, delta);
        const result = await llmProvider.complete(systemPrompt, userMessage, { maxTokens: 800, timeout: 30000 });
        const parsed = parseJSON(result.text);
        if (parsed && typeof parsed.shouldAlert === 'boolean') {
          evaluation = parsed;
          evalSource = 'llm';
        }
      } catch {}
    }

    if (!evaluation) evaluation = this._ruleBasedEvaluation(newSignals, delta);
    if (!evaluation?.shouldAlert) return false;

    const sent = await this.sendMessage(this._formatAlert(evaluation, delta, evalSource));
    if (!sent) return false;

    for (const s of newSignals) {
      const key = this._signalKey(s);
      memory.markAsAlerted(key, new Date().toISOString());
      this._recordContentHash(s);
    }
    return true;
  }
}
