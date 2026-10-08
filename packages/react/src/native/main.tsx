import { createRoot } from 'react-dom/client'
import { NativeEditor } from '#native/NativeEditor'
import '#native/style.css'

const element = document.getElementById('root')
if (element === null) throw new Error('Application root is missing')
createRoot(element).render(<NativeEditor />)
