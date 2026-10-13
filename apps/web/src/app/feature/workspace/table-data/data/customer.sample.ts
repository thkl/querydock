export interface CustomerRow {
  id: number;
  name: string;
  email: string;
  plan: string;
  status: string;
  createdAt: string;
}

export interface TableFieldDescriptor {
  field: keyof CustomerRow;
  label: string;
  type: 'text' | 'number' | 'date';
  width: number;
  editable: boolean;
  values?: readonly string[];
  customEditor?: 'status';
}

export const customerFields: readonly TableFieldDescriptor[] = [
  { field: 'id', label: 'ID', type: 'number', width: 76, editable: false },
  { field: 'name', label: 'Name', type: 'text', width: 190, editable: true },
  { field: 'email', label: 'Email', type: 'text', width: 250, editable: true },
  { field: 'plan', label: 'Plan', type: 'text', width: 126, editable: true, values: ['Starter', 'Team', 'Business'] },
  { field: 'status', label: 'Status', type: 'text', width: 126, editable: true, values: ['Active', 'Trial', 'Paused'], customEditor: 'status' },
  { field: 'createdAt', label: 'Created', type: 'date', width: 140, editable: false },
];

const people = [
  'Amara Chen', 'Milo Fischer', 'Sofia Patel', 'Theo Martin', 'Nina Bauer',
  'Elias Kim', 'Lena Murphy', 'Jonas Weber', 'Maya Laurent', 'Owen Brooks',
  'Leila Haddad', 'Felix Novak', 'Priya Shah', 'Noah Schmidt', 'Eva Rossi',
  'Kai Andersson', 'Clara Nguyen', 'Leo Costa', 'Zara Ahmed', 'Finn Olsen',
];
const plans = ['Starter', 'Team', 'Business'];
const statuses = ['Active', 'Active', 'Trial', 'Paused'];

/** Demo rows used only to prove grid behavior before database reads exist. */
export const sampleCustomers: CustomerRow[] = Array.from({ length: 64 }, (_, index) => {
  const id = index + 1;
  const person = people[index % people.length];
  const localPart = person.toLowerCase().replaceAll(' ', '.');

  return {
    id,
    name: person,
    email: `${localPart}${id > people.length ? id : ''}@example.dev`,
    plan: plans[index % plans.length],
    status: statuses[index % statuses.length],
    createdAt: `2025-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
  };
});
