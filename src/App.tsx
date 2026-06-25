import * as Sentry from '@sentry/react'
import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  const triggerError = () => {
    throw new Error('Test error for Sentry')
  }

  return (
    <Sentry.ErrorBoundary
      fallback={<div style={{ padding: 20 }}>页面出错了,请刷新重试</div>}
      onError={(error, componentStack) => {
        console.error('Caught by ErrorBoundary:', error, componentStack)
      }}
    >
      <div className="app">
        <header className="app-header">
          <h1>FE Deploy</h1>
          <p>前端工程化实践项目 · 部署 / CI-CD / CDN / 缓存</p>
          <p>use cloudflare cdn and r2</p>
        </header>
        <main className="app-main">
          <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
          <button onClick={triggerError}>Trigger Error</button>
          <p>当前环境：{import.meta.env.MODE}</p>
        </main>
      </div>
    </Sentry.ErrorBoundary>
  )
}

export default App
