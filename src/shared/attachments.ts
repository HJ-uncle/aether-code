import { PROJECT_DATA_DIRECTORY } from './project-storage'

/** Keep IDE-generated files away from application-owned folders such as uploads/. */
export const ATTACHMENTS_DIRECTORY = `${PROJECT_DATA_DIRECTORY}/attachments`
