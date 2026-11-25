/**
 * GPU turn-taking. gpt-oss:20b and SDXL can't both sit in 16 GB of video memory,
 * so before a chat we free ComfyUI's models, and before an image job (M5) we
 * unload the chat model. Turned off in Settings when smaller models fit together.
 */
import { log } from '../log'
import type { ComfyClient } from './comfy'
import type { OllamaClient } from './ollama'

export type GpuOwner = 'chat' | 'images' | null

export class GpuCoordinator {
  private owner: GpuOwner = null
  private lastChatModel: string | null = null

  constructor(
    private readonly enabled: () => boolean,
    private readonly ollama: OllamaClient,
    private readonly comfy: ComfyClient,
    private readonly onChange: (owner: GpuOwner) => void = () => {}
  ) {}

  current(): GpuOwner {
    return this.owner
  }

  async beforeChat(model: string): Promise<void> {
    if (this.enabled() && this.owner === 'images') {
      await this.comfy.free().catch((e: unknown) => log.warn(`could not free ComfyUI memory: ${String(e)}`))
    }
    this.lastChatModel = model
    this.set('chat')
  }

  async beforeImages(): Promise<void> {
    if (this.enabled() && this.owner === 'chat' && this.lastChatModel) {
      await this.ollama.unload(this.lastChatModel).catch((e: unknown) => log.warn(`could not unload chat model: ${String(e)}`))
    }
    this.set('images')
  }

  private set(o: GpuOwner): void {
    if (o === this.owner) return
    this.owner = o
    this.onChange(o)
  }
}
