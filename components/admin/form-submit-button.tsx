'use client'

import { Loader2 } from 'lucide-react'
import { useFormStatus } from 'react-dom'

import { Button, type ButtonProps } from '@/components/ui/button'

type FormSubmitButtonProps = ButtonProps & {
  pendingLabel?: string
}

export function FormSubmitButton({ children, pendingLabel, ...props }: FormSubmitButtonProps) {
  const { pending } = useFormStatus()

  return (
    <Button {...props} disabled={pending || props.disabled}>
      {pending ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {pendingLabel ?? 'Arbetar...'}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

