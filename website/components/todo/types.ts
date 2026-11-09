export interface Todo {
  id: string
  title: string
  done: boolean
  user_id?: string | null
  created_at?: string
}
