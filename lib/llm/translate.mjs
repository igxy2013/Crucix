// Translation service utilizing configured LLM Provider

export async function translateContent(provider, text, targetLang = 'zh-CN') {
  if (!provider?.isConfigured || !text) return text;

  const systemPrompt = `You are a professional translator. Translate the following text into ${targetLang}. 
Keep the translation concise, accurate, and suitable for a financial/military intelligence dashboard. 
Do NOT output any explanations, markdown blocks, or surrounding quotes. Only output the raw translated text.
If the text is already in the target language or cannot be translated, return it as is.`;

  try {
    const result = await provider.complete(systemPrompt, text, { maxTokens: 1024, temperature: 0.1, timeout: 30000 });
    const translated = result.text.trim();
    return translated || text;
  } catch (err) {
    console.error('[Translation] LLM translation failed:', err.message);
    return text;
  }
}

/**
 * Batch translates a list of items to avoid hitting rate limits too hard.
 * @param {LLMProvider} provider
 * @param {Array} items - Array of objects
 * @param {Function} extractTextFn - Function to get the text to translate from an item
 * @param {Function} updateItemFn - Function to update the item with translated text
 * @param {string} targetLang
 */
export async function batchTranslate(provider, items, extractTextFn, updateItemFn, targetLang = 'zh-CN') {
  if (!provider?.isConfigured || !items || items.length === 0) return items;

  // For very long lists, we might want to slice it, but for news/ideas 10-20 items is usually fine.
  const texts = items.map(extractTextFn);
  
  // Create a JSON payload to translate all at once to save tokens/requests
  const systemPrompt = `You are a professional translator. Translate the values of the provided JSON array into ${targetLang}.
Preserve the exact JSON array structure and order. Do NOT output markdown code blocks. Only output the raw JSON array.
Example input: ["text1", "text2"]
Example output: ["译文1", "译文2"]`;

  try {
    const result = await provider.complete(systemPrompt, JSON.stringify(texts), { maxTokens: 4096, temperature: 0.1, timeout: 60000 });
    let cleaned = result.text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const translatedTexts = JSON.parse(cleaned);
    
    if (Array.isArray(translatedTexts) && translatedTexts.length === items.length) {
      items.forEach((item, i) => updateItemFn(item, translatedTexts[i]));
    } else {
      console.warn('[Translation] Batch translation returned mismatched array length');
    }
  } catch (err) {
    console.error('[Translation] Batch translation failed:', err.message);
    // Fallback: translate individually if batch fails
    for (const item of items) {
      const original = extractTextFn(item);
      const translated = await translateContent(provider, original, targetLang);
      updateItemFn(item, translated);
    }
  }
  return items;
}
