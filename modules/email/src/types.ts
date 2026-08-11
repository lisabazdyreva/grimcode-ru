import type { editorDocumentSchema } from './schemas.js';
import type { z } from 'zod';

export type EditorDocument = z.infer<typeof editorDocumentSchema>;
