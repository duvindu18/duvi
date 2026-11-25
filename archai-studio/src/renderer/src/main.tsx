import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/app.css'
import { App } from './App'

const el = document.getElementById('root')
if (el) createRoot(el).render(<StrictMode><App /></StrictMode>)
