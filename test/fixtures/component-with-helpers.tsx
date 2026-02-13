import React, { useMemo, useCallback } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  lastActive: number;
}

// Pure arrow helper — should be ServerCompute (named, no browser globals)
const formatDate = (timestamp: number) => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Arrow helper that touches DOM — should be ClientInteractive
const scrollToUser = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
};

// Arrow helper that calls scrollToUser — taint should propagate
const navigateToUser = (id: string) => {
  scrollToUser(id);
  history.pushState(null, '', `/users/${id}`);
};

export function UserDashboard({ users }: { users: User[] }) {
  // Namespace hook call: React.useMemo — should detect hook context
  const admins = React.useMemo(() => {
    return users
      .filter(u => u.role === 'admin')
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [users]);

  // Destructured hook call — standard case
  const recentUsers = useMemo(() => {
    const oneDay = 86400000;
    return users.filter(u => Date.now() - u.lastActive < oneDay);
  }, [users]);

  const handleUserClick = useCallback((userId: string) => {
    navigateToUser(userId);
  }, []);

  // This component returns JSX — it must NOT be ServerCompute
  return (
    <div>
      <h2>Admins ({admins.length})</h2>
      {admins.map(u => (
        <div key={u.id} onClick={() => handleUserClick(u.id)}>
          {u.name} — {formatDate(u.lastActive)}
        </div>
      ))}
      <h2>Recent ({recentUsers.length})</h2>
    </div>
  );
}
