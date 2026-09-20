// CYC syntax-highlight manifest: the Prism core plus exactly the grammars the
// conversation code blocks and the file/diff viewers can label (see ./languages).
// Importing a Prism component mutates a shared grammar registry, and an extension
// must be imported after the grammar it builds on -- so these are grouped by
// language family with every base grammar ahead of its dependents.
import Prism from 'prismjs';

// Base grammars other definitions extend.
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup-templating';

// C-family (each extends clike; C++ extends C).
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-kotlin';

// ECMAScript stack (TypeScript and JSX extend JavaScript; TSX extends both).
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

// Data & query formats.
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-json5';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-graphql';

// Shell & scripting (PHP extends clike + markup-templating).
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-php';

// Systems & application languages.
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-swift';

// Stylesheets, docs & tooling output.
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-docker';

export default Prism;
