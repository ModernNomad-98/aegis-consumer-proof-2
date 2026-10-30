export function reportsEnabled(tenant: string, configured: string | undefined): boolean {
  return (configured ?? '').split(',').map(value => value.trim()).filter(value => ['tenant-a', 'tenant-b'].includes(value)).includes(tenant);
}
