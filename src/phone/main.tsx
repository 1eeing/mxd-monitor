import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import PhoneApp from './PhoneApp'
import './phone.css'

const el = document.getElementById('root')
if (!el) throw new Error('手机端页面缺少 #root 挂载点')

createRoot(el).render(
  <StrictMode>
    <PhoneApp />
  </StrictMode>,
)
