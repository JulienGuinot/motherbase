// Import order is evaluation order: install sets the globals the figures read.
import { FIGURES, HL } from './install'
import './figures/platters.js'
import './figures/pistons.js'
import './figures/gyroscope.js'
import './figures/rack.js'
import './figures/sprawl.js'
import './figures/gateway.js'
import './figures/spark.js'
import './figures/dominoes.js'
import './figures/rest.js'
import './figures/breakers.js'

export { FIGURES, HL }
export type { CustomFigureDef } from './install'
