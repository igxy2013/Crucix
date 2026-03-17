// MiniMax Provider — Anthropic-compatible API

import { LLMProvider } from './provider.mjs';

export class MinimaxProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name = 'minimax';
    this.apiKey = config.apiKey;
    // Default to MiniMax-M2.5 if no model specified
    this.model = config.model || 'MiniMax-M2.5';
  }

  get isConfigured() { return !!this.apiKey; }

  async complete(systemPrompt, userMessage, opts = {}) {
    // Using MiniMax's Anthropic-compatible API endpoint as per official documentation
    const res = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens || 4096,
        system: systemPrompt,
        messages: [
          { 
            role: 'user', 
            content: [
              { type: 'text', text: userMessage }
            ] 
          }
        ]
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`MiniMax API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    
    let text = '';
    let thinking = '';
    
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block && typeof block === 'object') {
          if (block.type === 'text' && block.text) text += block.text;
          if (block.type === 'thinking' && block.thinking) thinking += block.thinking;
        } else if (typeof block === 'string') {
          text += block;
        }
      }
    } else if (data.content && typeof data.content === 'string') {
      text = data.content;
    }

    const finalText = (text || thinking || '').trim();
    if (!finalText) {
      console.warn('[MiniMax] Empty response text. Raw data:', JSON.stringify(data).substring(0, 500));
    }

    return {
      text: finalText,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      model: data.model || this.model,
    };
  }
}
