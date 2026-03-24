import { Router, type IRouter } from "express";
import healthRouter from "./health";
import extractLinksRouter from "./extract-links";

const router: IRouter = Router();

router.use(healthRouter);
router.use(extractLinksRouter);

export default router;
