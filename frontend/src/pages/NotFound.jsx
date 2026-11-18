import { Link } from 'react-router-dom';
import { Button, EmptyState } from '../components/ui.jsx';

export default function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        title="That page does not exist"
        description="The link may be out of date. The inbox is the usual place to start."
        action={
          <Link to="/">
            <Button>Go to the inbox</Button>
          </Link>
        }
      />
    </div>
  );
}
