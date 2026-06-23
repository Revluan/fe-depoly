import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'

describe('App', () => {
  it('renders the title', () => {
    render(<App />)
    expect(screen.getByText('FE Deploy')).toBeInTheDocument()
  })

  it('counter increments on click', async () => {
    const user = userEvent.setup()
    render(<App />)
    const button = screen.getByRole('button')
    expect(button.textContent).toBe('count is 0')
    await user.click(button)
    expect(button.textContent).toBe('count is 1')
  })
})
