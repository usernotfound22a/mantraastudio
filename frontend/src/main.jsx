import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// App owns the QueryClient and the Router, so that the auth gate can live
// inside the router (it needs useLocation). Keeping either one here would give
// the app two QueryClients.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
