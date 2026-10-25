import { redirect } from 'next/navigation';

/** The reports open on the sales summary (the band's Reports tab goes there too). */
export default function ReportsPage() {
  redirect('/reports/sales');
}
