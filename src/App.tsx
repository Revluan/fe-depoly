import * as Sentry from '@sentry/react'
import { useState } from 'react'
import './App.css'

declare global {
  interface Window {
    __APP_CONFIG__?: {
      env: string
      version: string
      artifactId: string
      releaseId: string | null
      releaseName: string | null
      canary: boolean
      deployTime: string
    }
  }
}

function App() {
  const [count, setCount] = useState(0)
  const [apiResult, setApiResult] = useState('')
  const config = window.__APP_CONFIG__

  const triggerError = () => {
    throw new Error('Test error for Sentry')
  }

  const callApi = async () => {
    try {
      const res = await fetch('/api/version')
      const data = await res.json()
      setApiResult(JSON.stringify(data))
    } catch (err) {
      setApiResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
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
          <h1>FE Deploy {config?.canary ? '(Canary)' : ''}</h1>
          <p>前端工程化实践项目 · 混合部署</p>
          <p>
            Version: {config?.version ?? 'unknown'} · Env: {config?.env ?? 'unknown'} · Deploy:{' '}
            {config?.deployTime ?? 'unknown'}
          </p>
          <p>
            Artifact: {config?.artifactId ?? 'unknown'}
            {config?.releaseId ? ` · Release: ${config.releaseName ?? config.releaseId}` : ''}
          </p>
        </header>
        <main className="app-main">
          <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
          <button onClick={triggerError}>Trigger Error</button>
          <button onClick={callApi}>Call BFF</button>
          <p>当前环境：{import.meta.env.MODE}</p>
          <p>BFF Response: {apiResult || '(尚未调用)'}</p>
        </main>
      </div>
    </Sentry.ErrorBoundary>
  )
}

export default App
