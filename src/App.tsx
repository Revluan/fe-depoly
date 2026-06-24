import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="app">
      <header className="app-header">
        <h1>FE Deploy</h1>
        <p>前端工程化实践项目 · 部署 / CI-CD / CDN / 缓存</p>
        <p>docker test</p>
      </header>
      <main className="app-main">
        <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
        <p>当前环境：{import.meta.env.MODE}</p>
      </main>
    </div>
  )
}

export default App
