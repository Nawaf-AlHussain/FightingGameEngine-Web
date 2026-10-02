'use client';

import SettingsMenu from '@/components/SettingsMenu';
import { useWipeNavigation } from '@/components/WipeTransition';

export default function SettingsPage() {
  const { navigate } = useWipeNavigation();

  const handleCancel = () => {
    navigate('/lobby');
  };

  return <SettingsMenu onCancel={handleCancel} />;
}
