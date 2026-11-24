import windowsIcon from '../../build/icon.ico?asset&asarUnpack'
import appIcon from '../../resources/icon.png?asset&asarUnpack'

export { appIcon }

// Windows selects a native ICO size for the display DPI; macOS uses the app bundle icon.
export const nativeWindowIcon = process.platform === 'win32' ? windowsIcon
  : process.platform === 'linux' ? appIcon : undefined
