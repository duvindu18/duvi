import { z } from 'zod'

export const ProjectName = z.string().trim().min(1, 'Give the project a name').max(120, 'Keep the name under 120 characters')

export const ProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean()
})
export type Project = z.infer<typeof ProjectSchema>
