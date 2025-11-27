# Contributing to Ocearo Core

First off, thank you for considering contributing to Ocearo Core! It's people like you that make Ocearo Core such a great tool for the sailing community.

## Code of Conduct

By participating in this project, you are expected to uphold our Code of Conduct:

- Be respectful and inclusive
- Be patient with newcomers
- Focus on what is best for the community
- Show empathy towards other community members

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

**Bug Report Template:**

```markdown
**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Configure plugin with '...'
2. Trigger action '...'
3. See error

**Expected behavior**
A clear description of what you expected to happen.

**Environment:**
- Signal K Server version: [e.g., 1.46.0]
- Node.js version: [e.g., 18.17.0]
- OS: [e.g., Raspberry Pi OS, Ubuntu 22.04]
- Ocearo Core version: [e.g., 1.0.0]

**Logs**
Include relevant log output from Signal K server.

**Additional context**
Add any other context about the problem here.
```

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

- Use a clear and descriptive title
- Provide a detailed description of the proposed enhancement
- Explain why this enhancement would be useful to most users
- List any alternative solutions you've considered

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Install dependencies**: `npm install`
3. **Make your changes** following our coding standards
4. **Test your changes** thoroughly
5. **Update documentation** if needed
6. **Submit a pull request**

#### Pull Request Guidelines

- Follow the existing code style
- Write clear, descriptive commit messages
- Include tests for new functionality
- Update the README.md if needed
- Reference any related issues

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- Signal K Server (for testing)
- Ollama (optional, for LLM testing)
- Piper or eSpeak (optional, for TTS testing)

### Getting Started

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/ocearo-core.git
cd ocearo-core/plugin

# Install dependencies
npm install

# Run linting
npm run lint

# Run tests
npm test
```

### Testing with Signal K

1. Link the plugin to your Signal K installation:
   ```bash
   cd ~/.signalk/node_modules
   ln -s /path/to/ocearo-core/plugin ocearo-core
   ```

2. Restart Signal K server

3. Enable the plugin in Admin UI

### Code Style

We use ESLint for code quality. Key conventions:

- **No `var`** - Use `const` or `let`
- **Explicit types** - Avoid ambiguous variable names
- **4 spaces** indentation
- **Braces on new lines** for classes and methods
- **JSDoc comments** for public methods

Example:
```javascript
/**
 * Analyze weather conditions and generate recommendations
 * @param {Object} vesselData - Current vessel data from Signal K
 * @param {Object} context - Memory context
 * @returns {Promise<Object>} Analysis result with recommendations
 */
async analyzeConditions(vesselData, context)
{
    const weatherData = await this.weatherProvider.getWeatherData(vesselData.position);
    
    if (!weatherData?.current)
    {
        throw new Error('Weather data incomplete');
    }
    
    // ... implementation
}
```

### Commit Messages

Follow this format:
```
[Type] - Short description

Longer description if needed.

Fixes #123
```

Types:
- `[Feature]` - New features
- `[Bug]` - Bug fixes
- `[Cleanup]` - Code cleanup/refactoring
- `[Docs]` - Documentation changes
- `[Test]` - Test additions/changes

### Adding New Features

#### Adding a New Analysis Module

1. Create file in `src/analyses/`:
   ```javascript
   class MyAnalyzer {
       constructor(app, config, llm) {
           this.app = app;
           this.config = config;
           this.llm = llm;
       }
       
       async analyze(vesselData, context) {
           // Implementation
       }
   }
   
   module.exports = MyAnalyzer;
   ```

2. Register in `src/brain/index.js`

3. Add i18n translations in `src/common/index.js`

#### Adding a New Data Provider

1. Create file in `src/dataprovider/`:
   ```javascript
   class MyDataProvider {
       constructor(app, config) {
           this.app = app;
           this.config = config;
       }
       
       async start() { }
       async stop() { }
       async getData(params) { }
   }
   
   module.exports = MyDataProvider;
   ```

2. Register in main `index.js`

#### Adding Translations

Add entries to both `en` and `fr` sections in `src/common/index.js`:

```javascript
const i18n = {
    translations: {
        en: {
            my_new_key: 'English text with {variable}',
            // ...
        },
        fr: {
            my_new_key: 'Texte français avec {variable}',
            // ...
        }
    }
};
```

## Project Structure

```
plugin/
├── index.js              # Plugin entry point
├── schema.json           # Configuration schema for Admin UI
├── src/
│   ├── brain/           # Orchestrator and scheduling
│   ├── analyses/        # Analysis modules (weather, sail, alerts)
│   ├── dataprovider/    # Data providers (SignalK, weather, tides)
│   ├── llm/             # LLM integration (Ollama)
│   ├── voice/           # TTS output (Piper, eSpeak)
│   ├── memory/          # Contextual memory management
│   ├── logbook/         # Logbook integration
│   └── common/          # Shared utilities, i18n, constants
└── docs/                # Documentation
```

## Questions?

Feel free to open an issue with the `question` label or start a discussion.

## Recognition

Contributors will be recognized in:
- The project README
- Release notes
- The contributors page on GitHub

Thank you for contributing! ⛵
