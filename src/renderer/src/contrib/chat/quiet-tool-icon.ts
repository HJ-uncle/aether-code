import type { IconName } from '@renderer/workbench/icons'

/** Keep parent and delegated Work activity visually consistent. */
export function quietToolIcon(name: string): IconName {
  switch (name) {
    case 'list_files': return 'folder-outline'
    case 'read_file': return 'file'
    case 'grep': case 'search_content': case 'search_files': case 'search_history': return 'search'
    case 'execute_cmd': case 'run_command': case 'run_skill_script': return 'terminal'
    case 'write_file': return 'file-plus-outline'
    case 'edit_file': return 'file-edit-outline'
    case 'delete_file': return 'file-remove-outline'
    case 'office_document': case 'office_inspect': return 'file'
    case 'browser_screenshot': return 'image'
    default: return name.startsWith('browser_') ? 'eye-outline' : 'output'
  }
}
