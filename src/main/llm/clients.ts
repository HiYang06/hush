import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import OpenAI from 'openai'
import type { Connection } from './types'

export function anthropicClient({ baseUrl, apiKey }: Connection): Anthropic {
  // SDK v1 sends the key as a Bearer token; the official API accepts either header, but
  // Anthropic-compatible third parties often only read X-Api-Key, so send it the old way.
  return new Anthropic({
    apiKey,
    baseURL: baseUrl,
    defaultHeaders: { 'X-Api-Key': apiKey, Authorization: null }
  })
}

export function openAiClient({ baseUrl, apiKey }: Connection): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl })
}

export function geminiClient({ baseUrl, apiKey }: Connection): GoogleGenAI {
  return new GoogleGenAI({ apiKey, httpOptions: { baseUrl } })
}
